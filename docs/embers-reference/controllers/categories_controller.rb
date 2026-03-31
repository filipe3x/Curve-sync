class Admin::CategoriesController < Admin::BaseController
  def index
    categories = Category.all
    render json: categories.map(&:to_json)
  end

  def create
    category = Category.new category_params
    if category.save
      render json: { id: category.id.to_s }
    else
      render json: { errors: category.errors.full_messages }, status: :unprocessable_entity
    end
  end


  def update
    category = Category.find(params[:id])
    filtered_params = category_params.dup
    filtered_params[:entities] = filtered_params[:entities].reject(&:blank?) if filtered_params[:entities]

    Rails.logger.debug "Received params: #{params.inspect}"
    Rails.logger.debug "Filtered Category params: #{filtered_params.inspect}"

    if category.update(filtered_params)
      render json: { message: 'Category successfully updated.', category: category }
    else
      render json: { errors: category.errors.full_messages }, status: :unprocessable_entity
    end
  end

  def destroy
    category = Category.find(params[:id])
    if category.destroy
      render json: { message: 'Category deleted.' }
    else
      render json: { errors: category.errors.full_messages }, status: :unprocessable_entity
    end
  end

  def show
    category = Category.find(params[:id])
    if category
      render json: { category: category.to_json }
    else
      render json: { errors: ['Category not found'] }, status: :not_found
    end
  end

  private

  def category_params
    params.permit(:name, :icon, entities: [])
  end  
  
end
