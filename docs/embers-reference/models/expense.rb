class Expense < ApplicationRecord
  include Mongoid::Document
  include Mongoid::Timestamps
  include Mongoid::Paperclip

  field :entity, type: String
  field :amount, type: Float
  field :date, type: DateTime
  field :card, type: String
  field :digest, type: String
  field :created_at, type: DateTime
  field :updated_at, type: DateTime

  belongs_to :user, optional: true
  belongs_to :category, optional: true

  validates :entity, presence: true
  validates :amount, presence: true
  validates :date, presence: true
  validates :card, presence: true
  validates :digest, presence: true, uniqueness: {case_sensitive: true, message: 'This expense is already registered.'}

  before_create :assign_category

  def to_json
    {
      id: id.to_s,
      entity: entity,
      amount: amount,
      date: date,
      card: card,
      digest: digest,
      category: category ? category.name : nil,
      created_at: created_at,
      updated_at: updated_at,
      entity_total_spent: self.class.total_spent_with_entity(entity),
      category_total_spent: category ? category.total_spent : 0,
      category_icon: category ? category.icon.url : '',
    }
  end

  def self.search_query(params)
    query_params = {}
  
    query_params[:id] = params[:id] if params[:id].present?
    query_params[:entity] = %r{.*#{params[:entity]}.*}i if params[:entity].present?
    query_params[:card] = %r{.*#{params[:card]}.*}i if params[:card].present?
    query_params[:amount] = params[:amount] if params[:amount].present?
  
    # Determine the date range for expenses
    show_all = params[:show_all].present? && params[:show_all] == "true"
    show_week = params[:show_week].present? && params[:show_week] == "true"
  
    if show_all
      # No date filter
    elsif show_week
      start_date = Date.today.beginning_of_week
      end_date = Date.today.end_of_week(:sunday)
      query_params[:date] = { :$gte => start_date, :$lte => end_date }
    else
      today = Date.today
      start_date = if today.day >= 22
                     today.beginning_of_month + 21.days
                   else
                     (today - 1.month).beginning_of_month + 21.days
                   end
      query_params[:date] = { :$gte => start_date }
    end
  
    sort_column = params[:sort_column] || :date
    sort_type = params[:sort_type] || :desc
  
    expenses = Expense.where(query_params).order(sort_column => sort_type)

    if params[:category].present?
      # Find category by name
      category = Category.where(name: %r{.*#{params[:category]}.*}i).first
      if category
        expenses = expenses.where(category_id: category.id)
      else
        # No matching category found, so set expenses to an empty result
        expenses = Expense.none
      end
    end

    expenses
  end

  def self.search_all(params)
    query_params = {}

    query_params[:id] = BSON::ObjectId(params[:id]) if params[:id].present?
    query_params[:entity] = %r{.*#{params[:entity]}.*}i if params[:entity].present?
    query_params[:card] = %r{.*#{params[:card]}.*}i if params[:card].present?
    query_params[:amount] = params[:amount] if params[:amount].present?
    # if params[:category].present?
    #   query_params[:'category.name'] = %r{.*#{params[:category]}.*}i
    # end

    # Option to filter by date range if provided, otherwise fetch all expenses
    if params[:start_date].present? && params[:end_date].present?
      query_params[:date] = { :$gte => Date.parse(params[:start_date]), :$lte => Date.parse(params[:end_date]) }
    end

    sort_column = params[:sort_column] || :date
    sort_type = params[:sort_type] || :desc

    Expense.where(query_params).order_by(sort_column => sort_type)
  end  

  def my_month_start
    date = self.date
    if date.day >= 22
      Date.new(date.year, date.month, 22)
    else
      Date.new((date - 1.month).year, (date - 1.month).month, 22)
    end
  end

  def self.total_spent_with_entity(entity)
    where(entity: entity).sum(:amount)
  end

  private

  def set_category
    self.category = find_category_for_entity
  end

  def assign_category
    self.category = Category.where(:entities.in => [entity]).first || Category.find_or_create_by(name: 'General')
  end

  def find_category_for_entity
    # Find a category that matches the entity
    matching_category = Category.where(:entities.in => [entity]).first
    return matching_category.name if matching_category

    # If no matching category is found, try to find one based on past expenses
    past_expense = Expense.where(entity: entity, :category.ne => nil).first
    past_expense&.category
  end
  
end
